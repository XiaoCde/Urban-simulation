# -*-coding:utf-8 -*-
# python 3.9
# 生成 inflow和demand-supply map，这里要把tid和shp里的tid 对齐

"""
# @File       : 2_Inflow and SDR.py
# @software   : PyCharm  
# @Time       ：2025/7/22 22:32
# @Author     ：Wei Lyu
"""

import numpy as np
import pandas as pd

if __name__ == '__main__':
    path = 'D:/LW/ABM'

    sigma = 1

    # 设置随机数种子， stripplot每次抖动一致
    np.random.seed(42)

    relation = pd.read_csv(path + '/OutputData/cities_21/' + 'cities21_pop_CH.csv', header=None, usecols=[0, 3], encoding='gbk')
    cities_cn = relation[0].tolist()
    cities_en = relation[3].tolist()

    cities = ['北京市', '成都市', '重庆市', '大连市', '东莞市', '上海市', '青岛市', '杭州市', '哈尔滨市', '郑州市', '深圳市', '西安市', '长沙市', '武汉市',
              '佛山市', '济南市', '沈阳市', '广州市', '天津市', '昆明市', '南京市']

    positions = [cities_cn.index(element) for element in cities]
    cities_en = [cities_en[ind][:-3] for ind in positions]

    file = 'inflowPredShelter_MatchLabel.csv'
    for i in range(len(cities_en)):
        if cities_en[i] == 'xian':
            cities_en[i] = 'xi\'an'
        if cities_en[i] == 'haerbin':
            cities_en[i] = 'harbin'
        data_path = path + '/OutputData/Result_SSP585_pop2/cities_21_max/' + cities[i] + '/sigma=' + str(sigma)
        output_path = path + '\\Datasets'
        df = pd.read_csv(data_path + '\\' + file, header=0)
        df['Tid'] -= 1
        df1 = df[['Tid', 'pred_inflow']]
        df2 = df[['Tid', 'match_type']]
        df1.columns = ['Tid', 'Inflow mobility']
        df2.columns = ['Tid', 'Supply-demand relationship']
        df1.to_csv(output_path + '\\1-km inflow mobility datasets during 1-in-100-year rainfall events\\' + cities_en[i].capitalize()
                   + '.csv', header=True, index=False, encoding='utf-8')
        df2.to_csv(output_path + '\\1-km resolution map for the supply-demand relationship for emergency resources\\'
                   + cities_en[i].capitalize() + '.csv', header=True, index=False, encoding='utf-8')
        print(cities_en[i])


