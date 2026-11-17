# -*-coding:utf-8 -*-
# python 3.9

"""
# @File       : 5_match_stats.py
# @software   : PyCharm  
# @Time       ：2025/4/24 10:09
# @Author     ：Wei Lyu
"""

import numpy as np
import pandas as pd

if __name__ == '__main__':
    path = 'D:/LW/ABM/OutputData'

    sigma = 1

    # 设置随机数种子， stripplot每次抖动一致
    np.random.seed(42)

    relation = pd.read_csv(path + '/cities_21/' + 'cities21_pop_CH.csv', header=None, usecols=[0, 3], encoding='gbk')
    cities_cn = relation[0].tolist()
    cities_en = relation[3].tolist()

    cities = ['北京市', '成都市', '重庆市', '大连市', '东莞市', '上海市', '青岛市', '杭州市', '哈尔滨市', '郑州市', '深圳市', '西安市', '长沙市', '武汉市',
              '佛山市', '济南市', '沈阳市', '广州市', '天津市', '昆明市', '南京市']

    positions = [cities_cn.index(element) for element in cities]

    cities_en = [cities_en[ind][:-3] for ind in positions]
    for i in range(len(cities_en)):
        if cities_en[i] == 'xian':
            cities_en[i] = 'xi\'an'
        if cities_en[i] == 'haerbin':
            cities_en[i] = 'harbin'

    cols = ['city', 'median', 'mean', 'std']

    capacities = [500, 50000]
    for capacity in capacities:
        item = str(capacity)
        cols.extend([item, item + '_prop', item + '_deficit', item + '_surplus'])

    cols.extend(['count', 'prop', 'deficit', 'surplus', 'deficit_inflow_mean', 'surplus_inflow_mean', 'deficit_inflow_sum', 'surplus_inflow_sum', 'hazard', 'pop', 'human_expo'])

    summary = pd.DataFrame(columns=cols)
    df = pd.DataFrame()

    for i in range(len(cities)):
        city = cities[i]
        city_en = cities_en[i].capitalize()
        data_path = path + '/Result_SSP585_pop2/cities_21_max/' + city + '/sigma=' + str(sigma)

        inflowPredShelter = pd.read_csv(data_path + '/inflowPredShelter.csv', header=0)
        pop = pd.read_csv(path + '/Result_SSP585_pop2/cities_21_max/' + city + '/model_input.csv', header=0, usecols=['Con_pop']).values.sum()
        hazard = pd.read_csv(path + '/Result_SSP585_pop2/cities_21_max/' + city + '/model_input.csv', header=0, usecols=['Hazard']).values.sum()

        ori_num = len(inflowPredShelter)
        
        # 平均每个shelter服务的人口
        inflowPredShelter['inflowPerShelter'] = inflowPredShelter['pred_inflow'] / inflowPredShelter[
            'Shelter_count']

        # stats
        median = inflowPredShelter.loc[inflowPredShelter['inflowPerShelter'] != np.inf, 'inflowPerShelter'].median()
        mean = inflowPredShelter.loc[inflowPredShelter['inflowPerShelter'] != np.inf, 'inflowPerShelter'].mean()
        std = inflowPredShelter.loc[inflowPredShelter['inflowPerShelter'] != np.inf, 'inflowPerShelter'].std()
        new_row = [city_en, median, mean, std]

        for capacity in capacities:
            inflowPredShelter[str(capacity) + '_Match_type'] = 'balance'
            deficit_position = np.where((inflowPredShelter['Shelter_count'] * capacity - inflowPredShelter['pred_inflow']) < (-50))[
                0]
            inflowPredShelter.iloc[deficit_position, -1] = 'deficit'
            deficit = len(deficit_position)

            surplus_position = np.where((inflowPredShelter['Shelter_count'] * capacity - inflowPredShelter['pred_inflow']) > 50)[0]
            inflowPredShelter.iloc[surplus_position, -1] = 'surplus'
            surplus = len(surplus_position)

            count = deficit + surplus
            count_prop = count / ori_num

            new_row.extend([count, count_prop, deficit, surplus])

  
            if capacity == 500:
                tmp_col = inflowPredShelter.loc[deficit_position, 'pred_inflow'] - \
                                                                        inflowPredShelter.loc[deficit_position, 'Shelter_count'] * capacity
                human_expo = -sum(inflowPredShelter.loc[deficit_position, 'Shelter_count'] * capacity - inflowPredShelter.loc[deficit_position, 'pred_inflow'])
                print(human_expo == sum(tmp_col))


        last_columns = inflowPredShelter.iloc[:, -2:]

        deficit_rows = last_columns.apply(lambda row: all(row == 'deficit'), axis=1)
        surplus_rows = last_columns.apply(lambda row: all(row == 'surplus'), axis=1)
   
        deficit = deficit_rows.sum()
        surplus = surplus_rows.sum()
        count = deficit + surplus
        count_prop = count / ori_num
        deficit_inflow_mean = inflowPredShelter.loc[deficit_rows, 'pred_inflow'].mean()
        surplus_inflow_mean = inflowPredShelter.loc[surplus_rows, 'pred_inflow'].mean()

        deficit_inflow_sum = inflowPredShelter.loc[deficit_rows, 'pred_inflow'].sum()
        surplus_inflow_sum = inflowPredShelter.loc[surplus_rows, 'pred_inflow'].sum()

        new_row.extend([count, count_prop, deficit, surplus, deficit_inflow_mean, surplus_inflow_mean, deficit_inflow_sum, surplus_inflow_sum, hazard, pop, human_expo])
        summary.loc[len(summary)] = new_row

        inflowPredShelter['match_type'] = 'balance' 
        inflowPredShelter.loc[deficit_rows, 'match_type'] = 'deficit'
        inflowPredShelter.loc[surplus_rows, 'match_type'] = 'surplus'

        inflowPredShelter['human_expo'] = tmp_col
        inflowPredShelter['human_expo'] = inflowPredShelter['human_expo'].fillna(0.0)

        del tmp_col

        inflowPredShelter.to_csv(data_path + '/inflowPredShelter_MatchLabel.csv', header=True, index=False, encoding='utf-8')

        # 绘boxplot图用
        inflowPredShelter['City'] = city_en.capitalize()
        inflowPredShelter.dropna(subset=['inflowPerShelter'], inplace=True)
        tmp = inflowPredShelter.loc[inflowPredShelter['inflowPerShelter'] != np.inf, ['City', 'inflowPerShelter']]
        df = pd.concat([df, tmp], ignore_index=True)

    # df.to_csv(path + '/Result/cities_21_max/Inflow/sigma=' + str(sigma) + '/inflowPerShelter_forStripplot.csv', index=False, header=True)
    # summary.to_csv(path + '/Result/cities_21_max/Inflow/sigma=' + str(sigma) + '/NumPerShelter/match_stats.csv', index=False, header=True)