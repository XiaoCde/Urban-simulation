# -*-coding:utf-8 -*-
# python 得到上界、下界、实际值的csv

"""
# @File       : 15_CBA_CityStats.py
# @software   : PyCharm  
# @Time       ：2025/5/7 20:08
# @Author     ：Wei Lyu
"""

import numpy as np
import pandas as pd

if __name__ == '__main__':
    path = 'D:/LW/ABM/OutputData'

    sigma = 1
    ci = 95

    priority_scenarios = [0.05, 0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.40, 0.45, 0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80, 0.85, 0.90, 0.95, 1.00]
    scenarios = ['priority' + str(prop) for prop in priority_scenarios]

    metrics = ['sc', 'oti', 'aom', 'insur', 'dmf', 'del', 'ma', 'ce']
    headers = ['priority{}_{}'.format(p, s) for p in priority_scenarios for s in metrics]

    add = ['Cost', 'Benefit', 'BCR', 'NB']
    headers.extend(['priority{}_{}'.format(p, a) for p in priority_scenarios for a in add])
    headers.insert(0, 'City')

    cost_fields = ['oti', 'aom', 'insur']
    benefit_fields = ['dmf', 'del', 'ma', 'ce']

    # city list
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

    df_lowers = pd.DataFrame(columns=headers)
    df_uppers = pd.DataFrame(columns=headers)
    df_trues = pd.DataFrame(columns=headers)
    for i in range(len(cities)):
        city = cities[i]
        city_en = cities_en[i].capitalize()
        data_path = path + '/Result/cities_21_max/' + city + '/sigma=' + str(sigma)
        df = pd.read_csv(data_path + '/scenarios.csv', skiprows=[1])
        df_true = pd.read_csv(data_path + '/scenarios.csv', nrows=1)
        for s in scenarios:
            cost_fields_s = [s + '_' + f for f in cost_fields]
            benefit_fields_s = [s + '_' + f for f in benefit_fields]

            for d in [df, df_true]:
                d[s + '_Cost'] = d[cost_fields_s].sum(axis=1)
                d[s + '_Benefit'] = d[benefit_fields_s].sum(axis=1)
                d[s + '_BCR'] = d[s + '_Benefit'] / d[s + '_Cost']
                d[s + '_NB'] = d[s + '_Benefit'] - d[s + '_Cost']

        lowers = df.quantile(q=(100-ci)/2/100).to_frame().T
        uppers = df.quantile(q=(100-(100-ci)/2)/100).to_frame().T

        # 加上城市名
        lowers.insert(0, 'City', city_en.capitalize())
        uppers.insert(0, 'City', city_en.capitalize())
        df_true.insert(0, 'City', city_en.capitalize())

        if df_lowers.empty:
            df_lowers = lowers.copy()
        else:
            df_lowers = pd.concat([df_lowers, lowers], ignore_index=True)
        if df_uppers.empty:
            df_uppers = uppers.copy()
        else:
            df_uppers = pd.concat([df_uppers, uppers], ignore_index=True)
        if df_trues.empty:
            df_trues = df_true.copy()
        else:
            df_trues = pd.concat([df_trues, df_true], ignore_index=True)

        del lowers, uppers, df_true
        print(city)

    output_path = path + '/Result/cities_21_max/Inflow/sigma=1/NumPerShelter/'
    # df_lowers.to_csv(output_path + 'scenarios_lowers.csv', index=False, header=True)
    # df_uppers.to_csv(output_path + 'scenarios_uppers.csv', index=False, header=True)
    df_trues.to_csv(output_path + 'scenarios_trues.csv', index=False, header=True)



