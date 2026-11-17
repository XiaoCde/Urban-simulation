# -*-coding:utf-8 -*-
# python 3.9
# 把predicted的inflow和shelter连接到一起

"""
# @File       : 4_PredInflow_Shelter.py
# @software   : PyCharm  
# @Time       ：2024/7/26 15:48
# @Author     ：Wei Lyu
"""

import pandas as pd

if __name__ == '__main__':
    path = 'D:/LW/ABM/OutputData'

    relation = pd.read_csv(path + '/cities_21/' + 'cities21_pop_CH.csv', header=None, usecols=[0, 3], encoding='gbk')
    cities_cn = relation[0].tolist()
    cities_en = relation[3].tolist()

    cities = ['上海市', '北京市', '深圳市', '重庆市', '广州市', '成都市', '天津市', '武汉市', '东莞市', '西安市', '杭州市', '佛山市', '南京市', '沈阳市',
              '青岛市', '济南市', '长沙市', '哈尔滨市', '郑州市', '大连市', '昆明市']
    positions = [cities_cn.index(element) for element in cities]

    cities_en = [cities_en[ind][:-3] for ind in positions]
    for i in range(len(cities_en)):
        if cities_en[i] == 'xian':
            cities_en[i] = 'xi\'an'
        if cities_en[i] == 'haerbin':
            cities_en[i] = 'harbin'

    sigma = 1

    for i in range(len(cities)):
        city = cities[i]
        city_en = cities_en[i].capitalize()
        data_path = path + '/Result_SSP585_pop2/cities_21_max/' + city + '/sigma=' + str(sigma)

        file = 'shelter_tid.csv'
        shelter_tid = pd.read_csv(path + '/Result_SSP585_pop2/cities_21_max/' + city + '/' + file, header=0)
        shelter_tid['Tid'] = shelter_tid['Tid'] + 1 
        df = shelter_tid.groupby('Tid').count() 

        pred = pd.read_csv(data_path + '/inflowPred.csv', header=0, usecols=['Tid', 'pred_inflow'])
        pred.index = pred['Tid']
        for i, r in df.iterrows():
            pred.loc[i, 'Shelter_count'] = r['ID']

        pred.fillna({'Shelter_count': 0}, inplace=True)
        del df

        pred['Shelter_count'] = pred['Shelter_count'].astype(int)

        pred.to_csv(data_path + '/inflowPredShelter.csv', header=True, index=False)